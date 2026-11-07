"""0565: install-local post-only AI identity, idempotent group setup and no human credentials. Synthetic only."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, ask, make_agent, one, owner_sql
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401

SQL = "select pulse.operator_agent_chat(%s,%s,%s,%s) r"


def setup(api, emails, username="pulse-updates", chat="Studio updates"):
    with api.transaction():
        return api.execute(SQL, ("Pulse Updates", username, chat, emails)).fetchone()["r"]


def test_setup_is_idempotent_audited_and_never_creates_human_credentials(api, owner, worker, team):  # noqa: F811
    w = team
    before = one(api, w, w.manager, "select count(*) n from pulse.person where side='staff'")["n"]
    emails = [w.editor_handle, f"editor2@{w.domain}"]
    r = setup(api, emails)
    aid, cid = uuid.UUID(r["agentId"]), uuid.UUID(r["chatId"])
    assert setup(api, emails) == r
    assert owner_sql(owner, w, "select employee_id,owner_person_id,title,lane from pulse.agent_member where person_id=%s", (aid,)) == [
        {"employee_id": f"{w.code}-AI-001", "owner_person_id": w.editor, "title": "Posts updates", "lane": "quick"}]
    assert owner_sql(owner, w, "select p.side,m.post_only,pp.username from pulse.person p join pulse.agent_member m on m.person_id=p.id join pulse.people_profile pp on pp.person_id=p.id where p.id=%s", (aid,)) == [
        {"side": "agent", "post_only": True, "username": "pulse-updates"}]
    assert owner_sql(owner, w, "select created_by from pulse.chat_channel where id=%s", (cid,)) == [{"created_by": w.editor}]
    assert {x["person_id"]: x["role"] for x in owner_sql(owner, w, "select person_id,role from pulse.chat_member where channel_id=%s", (cid,))} == {
        w.editor: "admin", w.editor2: "member", aid: "member"}
    for table, column in [("pulse.account", "holder_person_id"), ("pulse.login_credential", "person_id"), ("pulse.role_assignment", "person_id"),
                          ("pulse_priv.native_token", "person_id"), ("pulse_priv.agent_key", "person_id"), ("pulse.hr_employment", "person_id")]:
        assert owner_sql(owner, w, f"select count(*) n from {table} where {column}=%s", (aid,)) == [{"n": 0}]
    assert one(api, w, w.manager, "select count(*) n from pulse.person where side='staff'")["n"] == before
    assert owner_sql(owner, w, "select actor_id,actor_account from pulse.audit_event where action='operator_agent_chat' and resource_id=%s", (str(cid),)) == [
        {"actor_id": None, "actor_account": "operator"}] * 2
    # A second tenant sees neither member nor group, and its email cannot be added to the install's chat.
    with api.transaction():
        set_tenant(api, uuid.uuid4())
        assert api.execute("select id from pulse.person where id=%s", (aid,)).fetchall() == []
        assert api.execute("select id from pulse.chat_channel where id=%s", (cid,)).fetchall() == []
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    p = subprocess.run(["node", "--input-type=module", "-e", r'''
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from './dist/app.js';
const pool=new Pool(JSON.parse(process.env.TEST_API_CONFIG)); const app=createApp(pool,pool);
try {
 const call=async path=>app.inject({url:'/api/v0/'+path,headers:{'cf-access-authenticated-user-email':process.env.TEST_MEMBER}});
 for (const path of ['people','people?lite=1']) {
  const r=await call(path); assert.equal(r.statusCode,200); assert(!r.json().people.some(p=>p.id===process.env.TEST_AGENT));
 }
 const r=await call('chats/'+process.env.TEST_CHAT+'/messages'); assert.equal(r.statusCode,200);
 assert.equal(r.json().members.find(p=>p.id===process.env.TEST_AGENT).agent,true);
} finally { await app.close(); await pool.end(); }
'''], cwd=Path(__file__).resolve().parents[2] / "services/api", env={**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
        "TEST_MEMBER": w.editor_handle, "TEST_AGENT": str(aid), "TEST_CHAT": str(cid)}, capture_output=True, text=True, timeout=60, check=False)
    assert p.returncode == 0, (p.stderr+p.stdout)[-3000:]


def test_post_only_mentions_replies_and_direct_messages_never_queue_a_run(api, owner, team):  # noqa: F811
    w = team
    # The invoking human is a leader; the negative result must not come from a staff permission refusal.
    r = setup(api, [ADMIN, w.editor_handle])
    aid, cid = uuid.UUID(r["agentId"]), uuid.UUID(r["chatId"])
    posted = as_agent(api, w, aid, "select pulse.chat_send(%s,'Update',null,'[]',%s,null) id", (cid, uuid.uuid4()))[0]["id"]
    mentioned = ask(api, w, w.manager, cid, "Thanks @pulse-updates")
    assert one(api, w, w.manager, "select mentions from pulse.chat_message where id=%s", (mentioned,))["mentions"] == [aid]
    for parent, quote in [(posted, None), (None, posted)]:
        one(api, w, w.manager, "select pulse.chat_send(%s,'Reply',%s,'[]',%s,%s)", (cid, parent, uuid.uuid4(), quote))
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (aid,))["id"]
    ask(api, w, w.manager, dm, "Hello @pulse-updates")
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_event where agent_id=%s", (aid,)) == [{"n": 0}]
    # Existing callable agents still queue normally.
    active, _ = make_agent(api, w, "callable-agent")
    direct = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (active,))["id"]
    ask(api, w, w.manager, direct, "Please help")
    assert owner_sql(owner, w, "select count(*) n from pulse.agent_event where agent_id=%s", (active,)) == [{"n": 1}]
    with pytest.raises(psycopg.errors.UniqueViolation):
        setup(api, [w.editor_handle], username="callable-agent")


def test_invalid_members_and_direct_helper_calls_are_refused_without_partial_setup(api, owner, worker, team):  # noqa: F811
    w = team
    for emails in [[], [None], [w.shared_handle], ["missing@other.example"], [w.editor_handle, "missing@other.example"]]:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            setup(api, emails)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (w.editor2,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        setup(api, [f"editor2@{w.domain}"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        api.execute("select pulse.agent_create_record('{}')")
    assert owner_sql(owner, w, "select count(*) n from pulse.people_profile where username='pulse-updates'") == [{"n": 0}]
