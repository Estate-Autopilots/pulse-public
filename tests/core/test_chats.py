"""Real PostgreSQL member/tenant isolation and authenticated Chats flows; all data is synthetic."""

import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def setup(worker, owner, api):
    w = build_world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, name in [
            (w.editor, "Editor One"),
            (w.editor2, "Editor Two"),
            (w.manager, "Pod Manager"),
            (w.lead, "Project Lead"),
        ]:
            worker.execute(
                "insert into pulse.people_profile(org_id,person_id,username,role,pod,department,evidence) values(%s,%s,%s,'Editor','Pod 1','Creative','synthetic')",
                (w.org, pid, name.lower().replace(" ", ".")),
            )
        worker.execute(
            "insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')",
            (w.org, w.manager),
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_refresh()")
    return w


def test_member_boundary_files_retention_and_membership(worker, owner, api):
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor2,)).fetchone()[
            "id"
        ]
        file = api.execute(
            "select pulse.chat_file_add(%s,'Synthetic.txt','text/plain',%s) id",
            (dm, b"Synthetic bytes"),
        ).fetchone()["id"]
        key = uuid.uuid4()
        attachments = json.dumps([{"id": str(file), "name": "Synthetic.txt"}])
        mid = api.execute(
            "select pulse.chat_send(%s,'Hi @editor.two',null,%s,%s) id",
            (dm, attachments, key),
        ).fetchone()["id"]
        assert (
            api.execute(
                "select pulse.chat_send(%s,'Hi @editor.two',null,%s,%s) id",
                (dm, attachments, key),
            ).fetchone()["id"]
            == mid
        )
        api.execute("select pulse.chat_react(%s,'👍')", (mid,))
        assert (
            api.execute("select count(*) n from pulse.chat_reaction").fetchone()["n"]
            == 1
        )
        api.execute("select pulse.chat_react(%s,'👍')", (mid,))
        assert (
            api.execute("select count(*) n from pulse.chat_reaction").fetchone()["n"]
            == 0
        )
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert (
            api.execute(
                "select * from pulse.chat_message where id=%s", (mid,)
            ).fetchall()
            == []
        )
        assert (
            api.execute("select * from pulse.chat_file_read(%s)", (file,)).fetchall()
            == []
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.chat_edit(%s,'Stolen')", (mid,))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert (
            api.execute("select * from pulse.chat_file_read(%s)", (file,)).fetchone()[
                "bytes"
            ]
            == b"Synthetic bytes"
        )
        msg = api.execute(
            "select mentions from pulse.chat_message where id=%s", (mid,)
        ).fetchone()
        assert w.editor2 in msg["mentions"]
        n = api.execute(
            "select title,telegram_status from pulse.notification"
        ).fetchone()
        assert n["title"] == "You were mentioned in Chats"
        assert n["telegram_status"] == "recipient_not_connected"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse.people_profile set pod='Pod 2',department='Social' where person_id=%s",
            (w.editor2,),
        )
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_refresh()")
        assert not api.execute(
            "select * from pulse.chat_channel where kind='pod' and name='Pod 1'"
        ).fetchall()
        assert api.execute(
            "select * from pulse.chat_channel where id=%s", (dm,)
        ).fetchone()
    with api.transaction():
        set_tenant(api, uuid.uuid4(), w.editor)
        assert api.execute("select * from pulse.chat_message").fetchall() == []
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_remove(%s,'Synthetic moderation')", (mid,))
        assert api.execute(
            "select body,attachments from pulse.chat_message where id=%s", (mid,)
        ).fetchone() == {"body": "", "attachments": []}
    with worker.transaction():
        set_tenant(worker, w.org)
        assert "Hi @editor.two" not in json.dumps(
            worker.execute(
                "select fields from pulse.audit_event where resource='chat_message'"
            ).fetchall()
        )
        worker.execute(
            "update pulse.chat_message set created_at=now()-interval '366 days' where id=%s",
            (mid,),
        )
        assert worker.execute("select pulse.chat_prune() n").fetchone()["n"] == 1


def test_authenticated_chats_http(worker, owner, api):
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in [w.manager, w.editor, w.editor2, w.lead]:
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    proc = subprocess.run(
        ["node", "test/chats-runner.mjs"],
        cwd=Path(__file__).resolve().parents[2] / "services/api",
        env={
            **os.environ,
            "TEST_API_CONFIG": json.dumps(config),
            "PULSE_ORG_ID": str(w.org),
            "TEST_PERSON": str(w.editor),
            "TEST_OTHER": str(w.editor2),
        },
        capture_output=True,
        text=True,
        timeout=40,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr


def test_invite_identity_expiry_and_exit_revocation(worker, owner, api):
    w = setup(worker, owner, api)
    people = [uuid.uuid4(), uuid.uuid4()]
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid in people:
            worker.execute(
                "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Sample Colleague','staff')",
                (pid, w.org),
            )
            worker.execute(
                "insert into pulse.people_profile(org_id,person_id,role,evidence) values(%s,%s,'Employee','synthetic')",
                (w.org, pid),
            )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        for pid in people:
            api.execute("select pulse.login_issue(%s,'Synthetic-issued-2026!')", (pid,))
        identities = api.execute(
            "select username,user_no,pulse_id from pulse.people_profile where person_id=any(%s) order by user_no",
            (people,),
        ).fetchall()
        assert [r["username"] for r in identities] == [
            "sample.colleague",
            "sample.colleague.2",
        ]
        assert len({r["pulse_id"] for r in identities}) == 2
        assert all(r["pulse_id"].startswith("PLS-") for r in identities)
        assert (
            api.execute(
                "select * from pulse.login_verify('sample.colleague','Synthetic-issued-2026!')"
            ).fetchone()["must_change"]
            is True
        )
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(
            "update pulse.login_credential set issued_at=now()-interval '8 days' where person_id=%s",
            (people[0],),
        )
    with api.transaction():
        set_tenant(api, w.org, people[0])
        assert (
            api.execute(
                "select * from pulse.login_verify('sample.colleague','Synthetic-issued-2026!')"
            ).fetchall()
            == []
        )
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor,)).fetchone()[
            "id"
        ]
    with api.transaction():
        set_tenant(api, w.org, people[0])
        api.execute(
            "insert into pulse.login_session(org_id,person_id,token_hash,expires_at) values(%s,%s,%s,now()+interval '12 hours')",
            (w.org, people[0], str(uuid.uuid4())),
        )
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute(
            "update pulse.person set status='inactive' where id=%s", (people[0],)
        )
        assert (
            worker.execute(
                "select count(*) n from pulse.chat_member where person_id=%s",
                (people[0],),
            ).fetchone()["n"]
            == 0
        )
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert (
            api.execute(
                "select status from pulse.login_credential where person_id=%s",
                (people[0],),
            ).fetchone()["status"]
            == "disabled"
        )
    with api.transaction():
        set_tenant(api, w.org, people[0])
        assert (
            api.execute(
                "select bool_and(revoked_at is not null) revoked from pulse.login_session where person_id=%s",
                (people[0],),
            ).fetchone()["revoked"]
            is True
        )
        assert (
            api.execute("select pulse.chat_has(%s) ok", (dm,)).fetchone()["ok"] is False
        )


def test_admin_company_moderation_and_invalid_attachments(worker, owner, api):
    w = setup(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        channel = worker.execute(
            "insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-private-team','Synthetic team','team') returning id",
            (w.org,),
        ).fetchone()["id"]
        worker.execute(
            "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)",
            (w.org, channel, w.editor),
        )
    for attachments in [
        [{"url": "javascript:alert(1)", "name": "invalid"}],
        [{"url": "https://example.test"}],
        [None],
        ["not an object"],
    ]:
        with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute(
                "select pulse.chat_send(%s,'Synthetic',null,%s,%s)",
                (channel, json.dumps(attachments), uuid.uuid4()),
            )
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        message = api.execute(
            "select pulse.chat_send(%s,'Synthetic message',null,'[]',%s) id",
            (channel, uuid.uuid4()),
        ).fetchone()["id"]
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert (
            api.execute("select pulse.chat_has(%s) ok", (channel,)).fetchone()["ok"]
            is True
        )
        api.execute(
            "select pulse.chat_remove(%s,'Synthetic admin moderation')", (message,)
        )
        assert (
            api.execute(
                "select removed_at is not null removed from pulse.chat_message where id=%s",
                (message,),
            ).fetchone()["removed"]
            is True
        )
