"""RUNNERS-FULL (migration 1572): a server's access level, AI employees on servers, and subscription logins from Pulse.

In the database: only an organisation admin changes a server's access, and every change is one ledger row with the
approver; a job above the server's level is refused whoever asks, and every job keeps the level and sandbox it ran at;
an AI employee reaches only servers that let AI employees in, up to their level; a pasted login code is never readable
through the API and goes to its own server once.
"""
import hashlib
import secrets
import uuid

import psycopg
import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _paired, _people


def _sha(x: str) -> str:
    return hashlib.sha256(x.encode()).hexdigest()


def _job(api, w, who, runner_id, profile="read-only"):
    job_id = "job_" + uuid.uuid4().hex
    approval = None if profile == "read-only" else '{"approvedBy":{"id":"x","name":"Synthetic admin"},"approvedAt":"2026-11-06T00:00:00Z"}'
    api.execute("""insert into pulse.runner_job(org_id,id,runner_id,kind,prompt,profile,approval,time_limit_sec,cost_cap_usd,requested_by)
                   values(%s,%s,%s,'claude','Synthetic prompt',%s,%s,600,1,%s)""", (w.org, job_id, runner_id, profile, approval, who))
    return job_id


def _agent(owner, w, manager):
    """A synthetic AI employee of the organisation (person side 'agent' with its agent_member row)."""
    aid = uuid.uuid4()
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic AI helper','agent')", (aid, w.org))
        n = owner.execute("select coalesce(max(employee_no),0)+1 n from pulse.agent_member where org_id=%s", (w.org,)).fetchone()["n"]
        owner.execute("insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id) values(%s,%s,%s,%s,%s)",
                      (w.org, aid, manager, n, f"SY-AI-{n:03d}"))
    return aid


def _as_agent(api, w, aid):
    set_tenant(api, w.org, aid)
    api.execute("select set_config('pulse.agent_session','on',true)")


def test_access_level_needs_an_admin_and_writes_the_ledger(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        r = api.execute("select access_level,sandbox,ai_employees from pulse.runner where id=%s", (runner_id,)).fetchone()
        assert r == {"access_level": "read-only", "sandbox": True, "ai_employees": False}, "new servers stay read-only"
        job = _job(api, w, p["admin"], runner_id)
        assert api.execute("select access_level,sandbox,requested_by_type from pulse.runner_job where id=%s", (job,)).fetchone() == \
            {"access_level": "read-only", "sandbox": True, "requested_by_type": "person"}
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                _job(api, w, p["admin"], runner_id, "write")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():      # a member never raises it
        set_tenant(api, w.org, p["person"])
        api.execute("select pulse.runner_access_set(%s,'full',false,true,'no')", (runner_id,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():      # nor the column directly
        set_tenant(api, w.org, p["admin"])
        api.execute("update pulse.runner set access_level='full' where id=%s", (runner_id,))
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        out = api.execute("select pulse.runner_access_set(%s,'read-write',true,false,'Synthetic: owner approved') a", (runner_id,)).fetchone()["a"]
        assert out["level"] == "read-write" and out["approvedBy"] == "Synthetic runner admin"
        job = _job(api, w, p["admin"], runner_id, "write")
        assert api.execute("select access_level,sandbox from pulse.runner_job where id=%s", (job,)).fetchone() == {"access_level": "read-write", "sandbox": True}
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                _job(api, w, p["admin"], runner_id, "shell")
        api.execute("select pulse.runner_access_set(%s,'full',false,false,null)", (runner_id,))
        job = _job(api, w, p["admin"], runner_id, "shell")
        assert api.execute("select access_level,sandbox from pulse.runner_job where id=%s", (job,)).fetchone() == {"access_level": "full", "sandbox": False}
        log = api.execute("""select approved_by,from_level,to_level,sandbox,reason from pulse.runner_access_log
                             where runner_id=%s order by at, to_level desc""", (runner_id,)).fetchall()
        assert [(x["from_level"], x["to_level"], x["sandbox"]) for x in log] == [("read-only", "read-write", True), ("read-write", "full", False)]
        assert {x["approved_by"] for x in log} == {p["admin"]} and log[0]["reason"] == "Synthetic: owner approved"
    for sql in ("insert into pulse.runner_access_log(org_id,runner_id,approved_by,to_level,sandbox,ai_employees) values(%s,%s,%s,'full',true,true)",
                "update pulse.runner_access_log set to_level='read-only' where org_id=%s and runner_id=%s and approved_by=%s",
                "delete from pulse.runner_access_log where org_id=%s and runner_id=%s and approved_by=%s"):
        with api.transaction():                              # the ledger only grows, and only through the function
            set_tenant(api, w.org, p["admin"])
            try:
                with api.transaction():
                    n = api.execute(sql, (w.org, runner_id, p["admin"])).rowcount
                assert n == 0, sql
            except (psycopg.errors.InsufficientPrivilege, psycopg.errors.CheckViolation):
                pass
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select count(*) n from pulse.runner_access_log").fetchone()["n"] == 2
    other = build_world(worker, owner, api)
    po = _people(worker, other, ["admin"], f"{other.code.lower()}.example")
    with api.transaction():                                  # another organisation's admin sees no ledger, changes nothing
        set_tenant(api, other.org, po["admin"])
        assert api.execute("select count(*) n from pulse.runner_access_log").fetchone()["n"] == 0
        with pytest.raises(psycopg.errors.NoDataFound):
            with api.transaction():
                api.execute("select pulse.runner_access_set(%s,'read-only',true,false,null)", (runner_id,))


def test_ai_employees_only_where_allowed_and_up_to_the_level(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin"], f"{w.code.lower()}.example")
    runner_id, _, _ = _paired(api, w, p["admin"])
    aid = _agent(owner, w, p["admin"])
    create = lambda profile="read-only": api.execute("select pulse.runner_agent_job_create(%s,'claude','Synthetic ask',null,%s,600,1) id",
                                                      (runner_id, profile)).fetchone()["id"]
    with api.transaction():
        _as_agent(api, w, aid)
        assert api.execute("select pulse.runner_agent_servers() s").fetchone()["s"] == []
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                create()
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # nor by a plain insert as the AI employee
        _as_agent(api, w, aid)
        _job(api, w, aid, runner_id)
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_access_set(%s,'read-only',true,true,'Synthetic: AI employees in')", (runner_id,))
    with api.transaction():
        _as_agent(api, w, aid)
        servers = api.execute("select pulse.runner_agent_servers() s").fetchone()["s"]
        assert [s["id"] for s in servers] == [runner_id] and servers[0]["accessLevel"] == "read-only"
        job = create()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                create("write")
        read = api.execute("select pulse.runner_agent_job_read(%s) j", (job,)).fetchone()["j"]
        assert read["status"] == "queued" and read["accessLevel"] == "read-only" and read["text"] is None
    with api.transaction():                                  # admins see it, as the AI employee's, with its level
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select requested_by,requested_by_type,access_level,approval from pulse.runner_job where id=%s", (job,)).fetchone() == \
            {"requested_by": aid, "requested_by_type": "ai-employee", "access_level": "read-only", "approval": None}
        api.execute("select pulse.runner_access_set(%s,'read-write',true,true,null)", (runner_id,))
    with api.transaction():                                  # write work carries the standing approval of the admin who set the level
        _as_agent(api, w, aid)
        wjob = create("write")
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        appr = api.execute("select approval from pulse.runner_job where id=%s", (wjob,)).fetchone()["approval"]
        assert appr["approvedBy"]["id"] == str(p["admin"]) and appr["standing"] is True
        with pytest.raises(psycopg.errors.InsufficientPrivilege):   # a person is not an AI employee session
            with api.transaction():
                api.execute("select pulse.runner_agent_job_read(%s)", (job,))
    with api.transaction():                                  # five at a time per server
        _as_agent(api, w, aid)
        for _ in range(3):
            create()
        with pytest.raises(psycopg.errors.ProgramLimitExceeded):
            with api.transaction():
                create()
    other = build_world(worker, owner, api)
    po = _people(worker, other, ["admin"], f"{other.code.lower()}.example")
    oid = _agent(owner, other, po["admin"])
    with api.transaction():                                  # another organisation's AI employee sees nothing of it
        _as_agent(api, other, oid)
        assert api.execute("select pulse.runner_agent_servers() s").fetchone()["s"] == []
        assert api.execute("select pulse.runner_agent_job_read(%s) j", (job,)).fetchone()["j"] is None
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                create()


def test_login_code_goes_to_its_server_once(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    runner_id, cred, _ = _paired(api, w, p["admin"])
    other_runner, other_cred, _ = _paired(api, w, p["admin"], hostname="box2")
    login = "lgn_" + secrets.token_hex(16)
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("insert into pulse.runner_login(org_id,id,runner_id,tool,requested_by) values(%s,%s,%s,'claude',%s)", (w.org, login, runner_id, p["admin"]))
        with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):   # not waiting yet
            with api.transaction():
                api.execute("select pulse.runner_login_code_put(%s,'SYNTHETIC-CODE#s')", (login,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # only admins ask for logins
        set_tenant(api, w.org, p["person"])
        api.execute("insert into pulse.runner_login(org_id,id,runner_id,tool,requested_by) values(%s,%s,%s,'claude',%s)",
                    (w.org, "lgn_" + secrets.token_hex(16), runner_id, p["person"]))
    with api.transaction():                                  # the server reports the link
        api.execute("select pulse.runner_session(%s)", (_sha(cred),))
        assert api.execute("update pulse.runner_login set status='waiting',url='https://claude.example/oauth/authorize?x=1',needs_code=true where id=%s", (login,)).rowcount == 1
    with api.transaction():                                  # another server never sees it
        api.execute("select pulse.runner_session(%s)", (_sha(other_cred),))
        assert api.execute("select count(*) n from pulse.runner_login").fetchone()["n"] == 0
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_login_code_put(%s,'SYNTHETIC-CODE#s')", (login,))
        assert api.execute("select status from pulse.runner_login where id=%s", (login,)).fetchone()["status"] == "verifying"
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # the code is never readable through the API
        set_tenant(api, w.org, p["admin"])
        api.execute("select * from pulse_priv.runner_login_code")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():   # an admin is not the server
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.runner_login_code_take(%s)", (login,))
    with api.transaction():
        api.execute("select pulse.runner_session(%s)", (_sha(other_cred),))
        assert api.execute("select pulse.runner_login_code_take(%s) c", (login,)).fetchone()["c"] is None
    with api.transaction():                                  # its own server takes it once
        api.execute("select pulse.runner_session(%s)", (_sha(cred),))
        assert api.execute("select pulse.runner_login_code_take(%s) c", (login,)).fetchone()["c"] == "SYNTHETIC-CODE#s"
        assert api.execute("select pulse.runner_login_code_take(%s) c", (login,)).fetchone()["c"] is None
    for bad in ("short", "with space"):
        with pytest.raises((psycopg.errors.CheckViolation, psycopg.errors.ObjectNotInPrerequisiteState)), api.transaction():
            set_tenant(api, w.org, p["admin"])
            api.execute("update pulse.runner_login set status='waiting' where id=%s", (login,))
            api.execute("select pulse.runner_login_code_put(%s,%s)", (login, "x y" if bad == "with space" else "x"))
    assert other_runner != runner_id
